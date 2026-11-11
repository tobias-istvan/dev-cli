# Credentials and private-information review

Reviewed locally on 10 November 2026, on `fix/pre-release-review`.

## Result

No actual credentials or confidential service endpoints were identified in the reviewed files or reachable Git history. Candidate token strings and credential literals were checked against their test context: they are synthetic fixtures in `test/atlassian.test.ts`, `test/day.test.ts`, `test/init.test.ts` and the new regression tests.

The scan covered 186 reachable historical file versions, current tracked and non-ignored untracked project files, and commit messages. It detected no private-key blocks, JWT-shaped credentials, HTTP URLs containing username/password pairs, private-network service URLs, or embedded absolute home-directory paths. Email candidates in project files are documentation/test examples.

Git history contains one author/committer identity. Making the repository public exposes its recorded name and email address, as well as the existing package author name, npm username and GitHub repository name. Those are personal/project metadata, not authentication secrets; they have been retained.

No credential rotation or further history rewriting was performed. The scan reads repository content only; it does not inspect the user's actual credential stores, environment secret values, or unrelated home-directory files.

## Repeating the check

```sh
python3 scripts/privacy-scan.py > /tmp/dev-privacy-scan.json
```

The report includes file paths, categories and short SHA-256 fingerprints, never matched values. A match is a candidate for human review, not proof of a leaked credential. The script scans all locally reachable refs; remote objects that have never been fetched are outside its scope. Ignored files and unreachable Git objects are outside its scope too.

This is a heuristic and manual-context review, not a guarantee that all secrets or private information have been detected. New files and commits need the same check before publication.
