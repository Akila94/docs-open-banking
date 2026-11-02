---
title: "Deploy APIs"
---
Go to `https://<APIM_HOST>:9443/publisher` and replace the \{version\} value.

Replace \{custom-path\} with the path, for example `/api/{custom-path}`.

The method returns a Map\<String, String> and writes to \<IS_HOME>/repository/logs.

| Parameter | Type |
|-----------|------|
| errors | List\<Error> |

Escaped \{braces\} stay as they are.

:::note
Set \<AUTH_HEADER_VALUE> to the \{token\}.
:::
