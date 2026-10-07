#!/usr/bin/env python3
"""Error-Code MCP V1 — schema-contract equivalence test (requires the MCP SDK / venv).

Asserts, for each public tool, that the schema the SDK ADVERTISES via MCPServer.list_tools()
(exactly what a client sees as inputSchema) is EQUAL to the canonical JSON schema in
schemas/<tool>.schema.json — with contract equality on the meaningful validation constraints.

Run: error-codes/mcp/.venv/bin/python error-codes/mcp/tests/test_schema.py
"""
import os, sys, json, asyncio

HERE = os.path.dirname(os.path.abspath(__file__))
MCP = os.path.dirname(HERE)
sys.path.insert(0, MCP)

import mcp_http_server as srv  # registers tools + applies canonical schema at import

SCHEMA_DIR = os.path.join(MCP, "schemas")
PUBLIC = ["resolve-error-code", "resolve-appliance-context"]

passed = 0; failed = 0
def check(n, cond, detail=""):
    global passed, failed
    ok = bool(cond); passed += ok; failed += (not ok)
    print(("  ok  " if ok else "  FAIL") + f" {n}" + ("" if ok else f"  :: {detail}"))

def canonical(name):
    return json.load(open(os.path.join(SCHEMA_DIR, name + ".schema.json")))["inputSchema"]

async def advertised():
    tools = await srv.server.list_tools()  # list[MCPTool] — exactly what a client receives
    return {t.name: t.input_schema for t in tools}

def obs_enum(schema):
    return schema["properties"]["observed"]["items"]["properties"]["type"].get("enum")

def main():
    adv = asyncio.run(advertised())
    names = sorted(adv.keys())
    check("public tool set is exactly the 2 tools", names == sorted(PUBLIC), str(names))

    for name in PUBLIC:
        a = adv.get(name); c = canonical(name)
        # full deep equality (contract equality, not "roughly the same fields")
        check(f"{name}: advertised inputSchema == canonical (deep equal)", a == c,
              f"diff keys: adv={sorted((a or {}).keys())} canon={sorted(c.keys())}")
        # 1 observed[].type enum identical
        check(f"{name}: observed.type enum identical", obs_enum(a) == obs_enum(c) and obs_enum(c) is not None, f"{obs_enum(a)}")
        # 2 required identical
        check(f"{name}: required identical", a.get("required") == c.get("required"), f"{a.get('required')} vs {c.get('required')}")
        # 3 additionalProperties identical (and False)
        check(f"{name}: additionalProperties identical & False", a.get("additionalProperties") == c.get("additionalProperties") == False, str(a.get("additionalProperties")))
        # 4 minLength constraints identical (all string props + observed.value)
        def minlens(s):
            out = {k: v.get("minLength") for k, v in s["properties"].items() if v.get("type") == "string"}
            out["observed.value"] = s["properties"]["observed"]["items"]["properties"]["value"].get("minLength")
            return out
        check(f"{name}: minLength constraints identical", minlens(a) == minlens(c), f"{minlens(a)} vs {minlens(c)}")
        # 7 revision optional in both (present, string, not required)
        def rev_ok(s):
            it = s["properties"]["observed"]["items"]
            return it["properties"].get("revision", {}).get("type") == "string" and "revision" not in it.get("required", [])
        check(f"{name}: revision optional in both", rev_ok(a) and rev_ok(c))
        # 8 no unexpected advertised top-level properties
        check(f"{name}: property sets identical", set(a["properties"].keys()) == set(c["properties"].keys()),
              f"{sorted(a['properties'])} vs {sorted(c['properties'])}")

    # resolve-error-code specifics: includeEnrichment default + region optional
    a = adv["resolve-error-code"]; c = canonical("resolve-error-code")
    check("6 includeEnrichment type/default identical",
          a["properties"]["includeEnrichment"] == c["properties"]["includeEnrichment"] == {"type": "boolean", "default": True},
          str(a["properties"].get("includeEnrichment")))
    check("region optional (present, not required)",
          "region" in a["properties"] and "region" not in a.get("required", []))

    # resolve-appliance-context specifics: minItems on observed
    a = adv["resolve-appliance-context"]; c = canonical("resolve-appliance-context")
    check("5 observed minItems identical (==1)",
          a["properties"]["observed"].get("minItems") == c["properties"]["observed"].get("minItems") == 1,
          str(a["properties"]["observed"].get("minItems")))

    print(f"\nError-Code MCP schema-equivalence: {passed} passed / {failed} failed  (total {passed+failed})")
    sys.exit(1 if failed else 0)

if __name__ == "__main__":
    main()
