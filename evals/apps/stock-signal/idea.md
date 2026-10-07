# Stock Signal

Merchants pick products and set a low-stock threshold. When inventory falls below it, the product page shows an "Only N left" badge, styled to match the theme.

## Acceptance checks

- Embedded admin page lists chosen products with their thresholds (Polaris index table, resource picker, save bar, empty and error states).
- Threshold is stored in an app-owned product metafield.
- Theme app block on product pages reads the metafield and renders the badge; colour and copy are theme-editor settings.
- `inventory_levels/update` webhook is handled; compliance webhooks are present.
- Scopes are exactly `read_products`, `read_inventory`, `write_products`.
- `run_checks()` is green and the app installs on the dev store.
