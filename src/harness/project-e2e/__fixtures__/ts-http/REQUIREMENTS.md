# Orders HTTP service requirements

R1. `POST /orders` with a JSON body `{"name": ...}` persists the order so it can be read back after the service restarts.
R2. `POST /orders` answers 201 with the created order as JSON with `ok: true`.
R3. `POST /orders` without a name answers 400 and writes nothing.
R4. `GET /orders/<id>` answers 200 with the stored order, or 404 when it does not exist.
