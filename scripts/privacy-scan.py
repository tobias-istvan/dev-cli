#!/usr/bin/env python3
"""Local review aid: scan reachable Git blobs and current project files; never print values."""
import hashlib
import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]

def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)

RULES = {
    "private-key": rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----",
    "provider-token": rb"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,}|ntn_[A-Za-z0-9]{20,}|figd_[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,})",
    "credential-literal": rb"(?i)(?:password|api[_-]?key|secret|token)\s*[:=]\s*[\x22\x27]([^\x22\x27\r\n]{12,})[\x22\x27]",
    "jwt": rb"\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}",
    "email": rb"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
    "absolute-home-path": rb"/(?:Users|home)/[A-Za-z0-9._-]+",
    "private-network-url": rb"https?://(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|[a-zA-Z0-9.-]+\.(?:internal|local|corp))\b",
    "url-credentials": rb"https?://[^\s/<>\x22\x27:]+:[^\s/<>\x22\x27@]+@",
}
findings = set()

def scan(data, name, source):
    for category, pattern in RULES.items():
        for match in re.finditer(pattern, data):
            # A fingerprint permits comparing candidates without exposing their values.
            value = match.group(1) if match.lastindex else match.group(0)
            findings.add((source, name, category, hashlib.sha256(value).hexdigest()[:12]))

blobs = 0
for entry in git("rev-list", "--objects", "--all").decode().splitlines():
    fields = entry.split(" ", 1)
    if len(fields) != 2:
        continue
    oid, name = fields
    if git("cat-file", "-t", oid).strip() != b"blob":
        continue
    blobs += 1
    scan(git("cat-file", "blob", oid), name, "history")

files = 0
names = set(git("ls-files", "-z").split(b"\0")) | set(git("ls-files", "--others", "--exclude-standard", "-z").split(b"\0"))
for raw in sorted(names):
    if not raw:
        continue
    name = raw.decode()
    file = ROOT / name
    if file.is_symlink() or not file.is_file():
        continue
    files += 1
    scan(file.read_bytes(), name, "working-tree")

scan(git("log", "--all", "--format=%B"), "commit messages", "history-metadata")
identities = set(git("log", "--all", "--format=%an <%ae>%n%cn <%ce>").splitlines())
print(json.dumps({
    "history_blobs": blobs,
    "working_files": files,
    "public_author_identities": len(identities),
    "candidates": [dict(zip(("source", "file", "category", "fingerprint"), entry)) for entry in sorted(findings)],
}, indent=2))
