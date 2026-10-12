#!/usr/bin/env python3
"""Build crm.csv from the company files in work/specs/midas-crm/companies/.

    python3 scripts/crm-build.py [crm_dir]
"""
import csv, os, re, sys

COLS = ["company", "domain", "website", "region", "city", "segment", "stage", "fit_score", "fit_why",
        "warm_path", "contact_1_name", "contact_1_role", "contact_1_url", "contact_2_name",
        "contact_2_role", "contact_2_url", "status", "verified"]

def front(path):
    text = open(path, encoding="utf-8").read()
    m = re.match(r"---\n(.*?)\n---", text, re.S)
    if not m:
        return None
    row = {}
    for line in m.group(1).splitlines():
        if ":" not in line or line.lstrip().startswith("#"):
            continue
        k, v = line.split(":", 1)
        row[k.strip()] = v.split("  #")[0].strip()
    return row

def main():
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/qubicle/work/specs/midas-crm")
    comp = os.path.join(root, "companies")
    rows, bad = [], []
    for name in sorted(os.listdir(comp)):
        if not name.endswith(".md") or name.startswith("_"):
            continue
        r = front(os.path.join(comp, name))
        (rows if r and r.get("company") else bad).append(r or name)
    rows.sort(key=lambda r: (r.get("region", ""), -int(r.get("fit_score") or 0), r.get("company", "")))
    with open(os.path.join(root, "crm.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLS, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    print(f"crm.csv: {len(rows)} companies" + (f"; skipped (no frontmatter): {', '.join(bad)}" if bad else ""))

if __name__ == "__main__":
    main()
