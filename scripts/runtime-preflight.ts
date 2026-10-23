async function get(url: string): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return response;
}

/** Check the HTML identity too: a different frontend may proxy to the expected API. */
export async function assertPageInstance(baseURL: string, instanceId: string): Promise<void> {
  const html = await (await get(baseURL)).text();
  if (!html.includes(`<meta name="lab-instance-id" content="${instanceId}">`)) {
    throw new Error(`The page at ${baseURL} does not belong to LAB_INSTANCE_ID=${instanceId}.`);
  }
}
