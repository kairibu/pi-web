#!/usr/bin/env python3
"""Fixed NDJSON worker for the SysIDE server capability.

The PI WEB SysIDE server plugin spawns this script once per worker process
(``python3 <this file>``) and keeps it alive across capability requests. The
worker imports the ``syside`` Python package exactly once, keeps at most one
loaded model in module state, and answers newline-delimited JSON requests with
newline-delimited JSON responses on stdout:

    request:  {"id": <int>, "op": <operation>, "payload": <object>}
    response: {"id": <int>, "ok": true,  "result": <json>}
              {"id": <int>, "ok": false, "error": "<message>"}

Only the fixed operations ``load``, ``check``, ``survey``, ``list_elements``,
and ``element_details`` are accepted. Nothing here evaluates caller-provided
code, runs shell commands, or imports caller-provided modules; ``load`` accepts
only a list of absolute file paths and replaces the active model.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import traceback
from typing import Any, Iterator
from urllib.parse import unquote, urlparse

# Import the SysIDE bindings exactly once, before the request loop. The import
# warms the shared runtime (executor thread pool, cached standard library
# environment) so the first model load is fast. SysIDE prints an unsupported
# platform notice to stdout during import on some hosts, which would corrupt
# the NDJSON response stream; capture import-time stdout and replay it on
# stderr instead.
with contextlib.redirect_stdout(io.StringIO()) as _import_stdout:
    import syside as syside  # noqa: F401  (runtime warm-up)

    from syside import try_load_model
    from syside.core import Element

_import_notice = _import_stdout.getvalue().strip()
if _import_notice:
    print(_import_notice, file=sys.stderr)

ALLOWED_OPERATIONS = frozenset({"load", "check", "survey", "list_elements", "element_details"})

# The SysML element kinds the element view supports. Runtime classes live in
# the ``syside.core`` namespace but are re-exported from the top-level
# ``syside`` package; the wire contract uses the top-level form.
SUPPORTED_ELEMENT_TYPES: tuple[Any, ...] = (
    syside.PartUsage,
    syside.PartDefinition,
    syside.RequirementUsage,
    syside.RequirementDefinition,
    syside.ActionUsage,
    syside.ActionDefinition,
)

# Contract type names ("syside.PartUsage", ...) keyed to their classes. The
# backend validates the `type` filter against the same names before dispatch.
SYSIDE_TYPE_BY_NAME: dict[str, Any] = {
    f"syside.{cls.__name__}": cls for cls in SUPPORTED_ELEMENT_TYPES
}

# Module state: at most one loaded model (plus its diagnostics) at a time.
# `load` replaces it in place; a failed load clears it so a stale partial model
# is never queried.
_active_model: Any | None = None
_active_diagnostics: Any | None = None


def _type_name(node_or_cls: Any) -> str:
    """Contract type name of a node or class (e.g. ``syside.PartUsage``)."""
    cls = node_or_cls if isinstance(node_or_cls, type) else type(node_or_cls)
    if cls.__module__ == "syside.core":
        # Runtime classes are re-exported from the top-level package; the
        # wire spec names the top-level form.
        return f"syside.{cls.__name__}"
    return f"{cls.__module__}.{cls.__name__}"


def _sysml_element(node: Any) -> dict[str, Any]:
    """Public JSON summary of one SysML element."""
    return {
        "type": _type_name(node),
        "declared_name": _declared_name(node),
        "qualified_name": _parse_qualified_name(node),
        "declared_short_name": _declared_short_name(node),
    }


def _parse_qualified_name(node: Any) -> list[str]:
    """Qualified name segments of an element, or [] when it has none."""
    qualified_name = node.qualified_name
    if not qualified_name:
        return []
    return [str(segment) for segment in qualified_name]


def _declared_short_name(node: Any) -> str | None:
    """Declared short name, or None when it is empty or absent."""
    short_name = node.declared_short_name
    return str(short_name) if short_name else None


def _declared_name(node: Any) -> str:
    """Declared name, falling back to the computed name when none is declared."""
    name = node.declared_name
    if name is None:
        name = node.name
    return str(name) if name else ""


def _is_supported(node: Any) -> bool:
    """Whether the node is one of the supported SysML element types."""
    return node.isinstance(SUPPORTED_ELEMENT_TYPES)


def _walk_owned(node: Any) -> Iterator[Any]:
    """Yield ``node`` and then every element of its ownership subtree."""
    yield node
    for child in node.owned_elements:
        yield from _walk_owned(child)


def _iter_named_elements() -> Iterator[Any]:
    """Yield every named element of the active model's user documents."""
    assert _active_model is not None
    for document in _active_model.user_docs:
        with document.lock() as locked:
            for node in locked.all_nodes(Element):
                if node.declared_name is not None:
                    yield node


def _find_package(qualified_name: list[str]) -> Any | None:
    """Find a package by qualified name, or None when it is not part of the model."""
    assert _active_model is not None
    for node in _iter_named_elements():
        if node.isinstance(syside.Package) and node.matches_qualified_name(qualified_name):
            return node
    return None


def _matches_search(node: Any, search: str) -> bool:
    """Case-insensitive substring match over declared and declared short name."""
    lowered = search.casefold()
    declared_name = node.declared_name
    if declared_name is not None and lowered in declared_name.casefold():
        return True
    short_name = node.declared_short_name
    return short_name is not None and lowered in short_name.casefold()


def handle_load(payload: dict[str, Any]) -> dict[str, Any]:
    """Replace the active model with one loaded from absolute file paths."""
    paths = payload.get("paths")
    if (
        not isinstance(paths, list)
        or not paths
        or not all(isinstance(path, str) and os.path.isabs(path) for path in paths)
    ):
        raise ValueError("load payload must include a non-empty list of absolute file paths: paths")
    global _active_model, _active_diagnostics
    try:
        model, diagnostics = try_load_model(paths=paths)
    except Exception:
        _active_model = None
        _active_diagnostics = None
        raise
    _active_model = model
    _active_diagnostics = diagnostics
    return {"files": len(paths), "errors": [message.message for message in diagnostics.errors]}


def handle_check(payload: dict[str, Any]) -> dict[str, Any]:
    """Return the error messages collected while loading the active model."""
    if _active_diagnostics is None:
        return {"errors": []}
    return {"errors": [message.message for message in _active_diagnostics.errors]}


def handle_survey(payload: dict[str, Any]) -> dict[str, Any]:
    """Survey the packages of the active model with per-type element counts.

    Returns ``{"projectPath": "", "packages": [...]}``; the service injects
    the authoritative workspace path into ``projectPath``, so the worker's
    value is an empty placeholder. Raises like ``element_details`` when no
    model is loaded (the service short-circuits empty workspaces, so this is a
    worker-internal guard against a stale slot, not a normal path).
    """
    if _active_model is None:
        raise ValueError("No model is loaded for this workspace")
    packages: list[dict[str, Any]] = []
    for node in _iter_named_elements():
        if not node.isinstance(syside.Package):
            continue
        counts = {type_name: 0 for type_name in SYSIDE_TYPE_BY_NAME}
        for candidate in _walk_owned(node):
            for type_name, cls in SYSIDE_TYPE_BY_NAME.items():
                if candidate.isinstance(cls):
                    counts[type_name] += 1
        packages.append(
            {
                "declared_name": _declared_name(node),
                "qualified_name": _parse_qualified_name(node),
                "element_counts": counts,
            }
        )
    packages.sort(key=lambda package: tuple(package["qualified_name"]))
    return {"projectPath": "", "packages": packages}


def handle_list_elements(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Return sorted element summaries filtered by type, package, and search."""
    requested_type = payload.get("type")
    if requested_type is not None:
        if not isinstance(requested_type, str) or requested_type not in SYSIDE_TYPE_BY_NAME:
            raise ValueError(
                "list_elements payload type must be one of the supported SysML element types"
            )
    package_qualified_name = payload.get("packageQualifiedName")
    if package_qualified_name is not None:
        if (
            not isinstance(package_qualified_name, list)
            or not package_qualified_name
            or not all(isinstance(segment, str) and segment != "" for segment in package_qualified_name)
        ):
            raise ValueError(
                "list_elements payload packageQualifiedName must be a non-empty list of non-empty strings"
            )
    search = payload.get("search")
    if search is not None:
        if not isinstance(search, str) or search == "":
            raise ValueError("list_elements payload search must be a non-empty string")

    if _active_model is None:
        return []
    type_class = SYSIDE_TYPE_BY_NAME[requested_type] if requested_type is not None else None
    if package_qualified_name is not None:
        package = _find_package(package_qualified_name)
        candidates: Any = _walk_owned(package) if package is not None else iter(())
    else:
        candidates = _iter_named_elements()

    elements = [
        _sysml_element(node)
        for node in candidates
        if _is_supported(node)
        and (type_class is None or node.isinstance(type_class))
        and (search is None or _matches_search(node, search))
    ]
    elements.sort(key=lambda element: (tuple(element["qualified_name"]), element["declared_name"]))
    return elements


def handle_element_details(payload: dict[str, Any]) -> dict[str, Any]:
    """Return the full detail of one element of the active model by qualified name."""
    qualified_name = payload.get("qualifiedName")
    if (
        not isinstance(qualified_name, list)
        or not qualified_name
        or not all(isinstance(segment, str) and segment != "" for segment in qualified_name)
    ):
        raise ValueError(
            "element_details payload must include a non-empty list of non-empty strings: qualifiedName"
        )
    if _active_model is None:
        raise ValueError("No model is loaded for this workspace")
    for node in _iter_named_elements():
        if not node.matches_qualified_name(qualified_name):
            continue
        return _element_detail(node)
    raise ValueError(
        f"No element with qualified name {'::'.join(qualified_name)} is part of the loaded model"
    )


def _element_detail(node: Any) -> dict[str, Any]:
    """Full detail of one element: documentation, heritage, subject, and I/O."""
    documentation = [str(doc.body) for doc in node.documentation]
    # The syside package exposes no subsetting surface, so subsetting is
    # reported as None instead of guessing from `heritage`: the heritage
    # container holds specializations/conjugations, which are not the same
    # relationship the model represents as subsetting, and duplicating
    # known-wrong data into the Subsetting section of the element view would
    # mislead users. Revisit when subsetting becomes distinguishable in syside.
    heritage_node = getattr(node, "heritage", None)
    if heritage_node is not None:
        # The container's truthiness may not reflect emptiness, so map the
        # collected elements and collapse an empty list to None explicitly.
        heritage = [_sysml_element(element) for element in heritage_node.elements] or None
    else:
        heritage = None
    subject: dict[str, Any] | None = None
    try:
        subject_parameter = getattr(node, "subject_parameter", None)
        if subject_parameter is not None:
            subject = _sysml_element(subject_parameter.basic_feature.heritage[0][1])
    except Exception:  # noqa: BLE001 - an exotic subject chain must not fail the request
        subject = None
    inputs: list[dict[str, Any]] | None = None
    outputs: list[dict[str, Any]] | None = None
    if node.isinstance((syside.ActionUsage, syside.ActionDefinition)):
        input_values = getattr(node, "inputs", None)
        if input_values is not None:
            collected = [_sysml_element(entry) for entry in input_values]
            if collected:
                inputs = collected
        output_values = getattr(node, "outputs", None)
        if output_values is not None:
            collected = [_sysml_element(entry) for entry in output_values]
            if collected:
                outputs = collected
    return {
        "type": _type_name(node),
        "declared_name": _declared_name(node),
        "qualified_name": _parse_qualified_name(node),
        "declared_short_name": _declared_short_name(node),
        "documentation": documentation if documentation else None,
        "heritage": heritage,
        "subsetting": None,
        "filepath": _filepath(node),
        "subject": subject,
        "inputs": inputs,
        "outputs": outputs,
    }


def _filepath(node: Any) -> str:
    """Filesystem path of the source document, or its raw URL when not file://."""
    url = str(node.document.url)
    parsed = urlparse(url)
    if parsed.scheme == "file":
        return unquote(parsed.path)
    return url


def dispatch(request: dict[str, Any]) -> Any:
    """Route one validated request to its fixed operation handler."""
    operation = request.get("op")
    if operation not in ALLOWED_OPERATIONS:
        raise ValueError(f"unsupported SysIDE worker operation: {operation!r}")
    payload = request.get("payload")
    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        raise ValueError("SysIDE worker request payload must be a JSON object")
    if operation == "load":
        return handle_load(payload)
    if operation == "check":
        return handle_check(payload)
    if operation == "survey":
        return handle_survey(payload)
    if operation == "list_elements":
        return handle_list_elements(payload)
    if operation == "element_details":
        return handle_element_details(payload)
    raise AssertionError(f"unreachable operation: {operation}")


def respond(request_id: Any, response: dict[str, Any], output_fd: int) -> None:
    """Emit one NDJSON response line on the saved stdout duplicate."""
    response["id"] = request_id
    os.write(output_fd, (json.dumps(response) + "\n").encode("utf-8"))


def main() -> None:
    """Read one NDJSON request per stdin line until stdin closes."""
    # Keep responses on the real stdout but route every other writer of stdout
    # to stderr for the process lifetime. The import-time redirect above only
    # covers module loading; any stray stdout output during a request (a
    # dependency or model code calling print) would corrupt the NDJSON stream
    # mid-flight, the client would poison the worker, and the next request
    # would reload into a fresh process that prints again - a silent failure
    # loop with no recovery path. Redirecting at the fd level (not just
    # sys.stdout) also catches os.write and C-level writes, so this is cheap
    # insurance for the same failure mode the import-time redirect anticipates.
    response_fd = os.dup(1)
    os.dup2(2, 1)
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            request_id = None
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise ValueError("SysIDE worker request must be a JSON object")
                request_id = request.get("id")
                result = dispatch(request)
                respond(request_id, {"ok": True, "result": result}, response_fd)
            except Exception as error:  # noqa: BLE001 - every request must get a response
                traceback.print_exc(file=sys.stderr)
                message = str(error) if str(error) else type(error).__name__
                respond(request_id, {"ok": False, "error": message}, response_fd)
    finally:
        os.close(response_fd)
    # stdin closed: the client asked us to stop.


if __name__ == "__main__":
    main()