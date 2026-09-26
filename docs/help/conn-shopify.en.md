# Connect your Shopify store

How to plug your Shopify store into Agents Workshop: orders, returns, customers and products all come through this connection.

## Shopify store

Create an app in Shopify's Dev Dashboard, install it on your store, and paste its Client ID and secret here. Shopify's access tokens expire every 24 hours — we renew them ourselves, so you don't have to.

**How**

1. Open the [Shopify Dev Dashboard](https://dev.shopify.com/dashboard) (Apps in the partners admin), click Create app, and pick "Custom" as the distribution method.
2. In the app's version settings, tick these scopes: read/write orders (`read_orders` / `write_orders`), read/write returns (`read_returns` / `write_returns`), read customers (`read_customers`), read products (`read_products`).
3. On the same page, request Protected customer data access and tick name, email and address. **Skip this and orders and customers come back empty — with no error.**
4. Click Install app and pick the store you want to connect. It must be a store in the same organization as the app.
5. Go back to the app's Settings page and copy the Client ID and Client secret.
6. Enter your store domain and those two values in the form. The secret stays on this computer only.

**Links**

- [Shopify Dev Dashboard](https://dev.shopify.com/dashboard)
- [Shopify client credentials to token (official docs)](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials)

## FAQ

- **Orders and customers are empty, but nothing errors**: almost always step 3 was skipped. Go back to the Dev Dashboard and request protected customer data (name / email / address).
- **Do I re-enter anything when the token expires?** No. Tokens last 24 hours and we renew them with the Client ID and secret you gave us.
- **I can't install the app on my store**: the app can only go on stores in the same organization. Check that the store and the app belong to the same one.
- **I want the AI to handle customer email**: that's a different connection — see [Connect a mailbox](help:conn-email).
