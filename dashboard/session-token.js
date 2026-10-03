/** Neon 0.5.0 caches /token as a session response. Force the actual JWT request. */
export async function requestStaffToken(client) {
  const { data, error } = await client.token({ fetchOptions: { headers: { 'X-Force-Fetch': '1' } } });
  if (error) throw Object.assign(new Error(error.message ?? 'Could not load your session.'), error);
  if (!data?.token) {
    throw Object.assign(new Error('Your session has expired. Sign in again to continue.'), { status: 401 });
  }
  return data.token;
}
