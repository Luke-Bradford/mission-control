# Start preview on Board and Agent PR chips (#1223)

The Board card and Agent run row offer **Start preview** only when the server says the open PR supports it. Starting becomes **Preview** once the server returns a URL. Unsupported repos have neither a start button nor a preview link.

These screenshots render the production components with the Board and Agent styles, using fixture data. The browser test mocks the preview-start response; it does not start or modify the live hub.

| Width | Before (light) | After (light) | Before (dark) | After (dark) |
|---|---|---|---|---|
| 1280 | [Before](preview-none-1280-light.png) | [After](preview-start-1280-light.png) | [Before](preview-none-1280-dark.png) | [After](preview-start-1280-dark.png) |
| 1600 | [Before](preview-none-1600-light.png) | [After](preview-start-1600-light.png) | [Before](preview-none-1600-dark.png) | [After](preview-start-1600-dark.png) |
| 1920 | [Before](preview-none-1920-light.png) | [After](preview-start-1920-light.png) | [Before](preview-none-1920-dark.png) | [After](preview-start-1920-dark.png) |

Validation: 320 component and page tests, plus 10 browser tests. The browser tests cover unsupported, startable and running previews at all three widths in both themes. They also click Start on each surface and check that the surrounding card or run does not open. Lint, typecheck and production build pass.
