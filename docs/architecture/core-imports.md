# Core imports

Core domain algorithms import shared vocabulary from the `*-model.ts` modules. Those modules contain data shapes and their defining constants; they do not import domain algorithms. `loop-shared.ts` holds the small loop/review helpers, and `rule-paths.ts` holds the immutable protection paths. The original domain modules re-export the moved public names, preserving existing imports and object identities.

`pnpm lint` runs `scripts/check-core-cycles.ts`. It uses TypeScript's resolver in Bundler mode to follow source aliases; the build uses NodeNext. It checks type-only imports, re-exports, import types, literal dynamic imports and the package's own barrel. Cycles are rejected even when TypeScript would erase their type-only edges. A future module can import a leaf without importing the algorithms that use it.

The extraction removed a 16-module cycle. The 1,231 runtime exports retain their names; functions and values are unchanged apart from adding the moved protected files to the hard-rule lists. Protection follows the code's new locations in both the fixed floor and the repository's Mission Control block.

## Layers

`packages/core/test/import-layers.test.ts` keeps the layers apart: core must not import server or web, and server and web must not import each other. It runs in CI with the rest of the tests (it is not part of `pnpm lint`). It reads the `src` folders of `packages/core`, `apps/server` and `apps/web` only; tests are not checked. Imports by package name (the `core`, `server` and `web` workspace packages) and relative imports both count. A break is reported as `Layer break: <file> imports <target>; <layer> must not import <layer>.`
