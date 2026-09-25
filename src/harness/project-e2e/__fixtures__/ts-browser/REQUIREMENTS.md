# Orders web page requirements

R1. The page at `/` lets a user type a name and press Create; the page then shows the created order's id and name, and a fresh navigation to `/orders/<id>` shows the stored order (the shown line alone is not persistence).
R2. `POST /orders` with a JSON body `{"name": ...}` persists the order and answers 201 with `ok: true`.
R3. `POST /orders` without a name answers 400 and writes nothing.
R4. `GET /orders/<id>` answers 200 with the stored order, or 404 when it does not exist.
