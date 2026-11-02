"""Generate docs/web/model_db.js from model_db.py for the pure-frontend WebUSB app."""
import json
import os
import model_db
import printer_core

os.makedirs(os.path.join("docs", "web"), exist_ok=True)
out_path = os.path.join("docs", "web", "model_db.js")

with open(out_path, "w", encoding="utf-8") as f:
    f.write("// Auto-generated from model_db.py — EUPL-1.2 licensed.\n")
    f.write("window.VALIDATED_MODELS = new Set(")
    f.write(json.dumps(sorted(printer_core.VALIDATED)))
    f.write(");\n\n")
    f.write("window.MODEL_DB = ")
    f.write(json.dumps(model_db.MODELS, indent=2, sort_keys=True))
    f.write(";\n")

print(f"Wrote {out_path} with {len(model_db.MODELS)} models.")
