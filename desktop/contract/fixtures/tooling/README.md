# Tooling fixtures. NOT the SignFlow contract.

These files only exercise the generator and validator. The model names are deliberately fake (`Tooling*`). The shapes mimic what FastAPI + Pydantic v2 emit (OpenAPI 3.1, `anyOf` with null, `$ref`, `Literal` discriminators, `date-time`, numeric bounds), so the pipeline is proven before the real schema exists.

The official contract comes from the backend's Pydantic models. See `../../README.md`.
