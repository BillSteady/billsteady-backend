import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createVtpassClient, VtpassError } from "./vtpass.ts";

function fakeFetch(response: { status: number; body: unknown }): typeof fetch {
  return (async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

Deno.test("verifyMerchant: parses a successful response with a fixed amount due", async () => {
  const client = createVtpassClient({
    baseUrl: "https://vtpass.invalid",
    apiKey: "key",
    secretKey: "secret",
    fetchImpl: fakeFetch({
      status: 200,
      body: { code: "000", content: { Customer_Name: "Jane Doe", Current_Bill_Amount: "18500" } },
    }),
  });

  const result = await client.verifyMerchant({ serviceID: "ikeja-electric", billersCode: "04521" });
  assertEquals(result.customerName, "Jane Doe");
  assertEquals(result.amountDue, 18500);
});

Deno.test("verifyMerchant: amountDue is null for services VTpass doesn't price at verify time", async () => {
  const client = createVtpassClient({
    baseUrl: "https://vtpass.invalid",
    apiKey: "key",
    secretKey: "secret",
    fetchImpl: fakeFetch({
      status: 200,
      body: { code: "000", content: { Customer_Name: "Jane Doe" } },
    }),
  });

  const result = await client.verifyMerchant({ serviceID: "ikeja-electric-prepaid", billersCode: "04521" });
  assertEquals(result.amountDue, null);
});

Deno.test("verifyMerchant: throws VtpassError on a non-2xx response", async () => {
  const client = createVtpassClient({
    baseUrl: "https://vtpass.invalid",
    apiKey: "key",
    secretKey: "secret",
    fetchImpl: fakeFetch({ status: 500, body: { error: "server error" } }),
  });

  await assertRejects(() => client.verifyMerchant({ serviceID: "x", billersCode: "y" }), VtpassError);
});

Deno.test("verifyMerchant: throws VtpassError when content is missing Customer_Name", async () => {
  const client = createVtpassClient({
    baseUrl: "https://vtpass.invalid",
    apiKey: "key",
    secretKey: "secret",
    fetchImpl: fakeFetch({ status: 200, body: { code: "000", content: {} } }),
  });

  await assertRejects(() => client.verifyMerchant({ serviceID: "x", billersCode: "y" }), VtpassError);
});

