# AUDIT seat: files outside the builder area

The builder seat could not commit these four hard-rule files. FLIGHT puts them on the branch: copy `AUDIT.md` to `roles/AUDIT.md`, apply each `.patch` with `git apply` from the repo root, then delete this folder.
