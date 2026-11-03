export const config = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000",
  oidcAuthority: process.env.NEXT_PUBLIC_OIDC_AUTHORITY ?? "http://localhost:8080/realms/starit",
  oidcClientId: process.env.NEXT_PUBLIC_OIDC_CLIENT_ID ?? "starit-web",
};
