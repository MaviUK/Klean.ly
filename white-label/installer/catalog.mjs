export const providers = Object.freeze([
  {
    id: "supabase", name: "Supabase", category: "Infrastructure",
    required: true, link: "https://supabase.com/dashboard",
    description: "Company-owned customer database, authentication and private storage.",
    mode: "oauth-integration", status: "Authorisation supported; permanent credential storage separately feature-gated",
    secret: "Never collect service_role or database credentials in the browser."
  },
  {
    id: "netlify", name: "Netlify", category: "Infrastructure",
    required: true, link: "https://app.netlify.com/",
    description: "Company-owned website hosting, custom domain and server functions.",
    mode: "oauth-planned", status: "Authorisation integration to be implemented",
    secret: "Deployment credentials stay only in the secure control plane."
  },
  {
    id: "google_maps", name: "Google Maps Platform", category: "Maps & routing",
    required: true, link: "https://console.cloud.google.com/google/maps-apis/overview",
    description: "Autocomplete, address lookup and mapping with the company's billing account.",
    mode: "restricted-key", status: "Enable required APIs and restrict keys to the deployed domain",
    secret: "Browser Maps key may be public but must be restricted; server keys remain server-side."
  },
  {
    id: "resend", name: "Resend", category: "Communications",
    required: false, link: "https://resend.com/domains",
    description: "Email reminders and booking confirmations from a verified company domain.",
    mode: "server-key", status: "Verify domain and configure secure sender credentials",
    secret: "RESEND_API_KEY is a server-only secret."
  },
  {
    id: "stripe", name: "Stripe", category: "Payments",
    required: false, link: "https://dashboard.stripe.com/",
    description: "Card payments, subscriptions and company-owned settlement.",
    mode: "oauth-or-server-key", status: "Account connection and webhook setup required",
    secret: "Stripe secret key and webhook signing secret remain server-side."
  },
  {
    id: "gocardless", name: "GoCardless", category: "Payments",
    required: false, link: "https://manage.gocardless.com/",
    description: "Company-owned direct debit collection.",
    mode: "oauth-or-server-key", status: "Account connection and webhook setup required",
    secret: "Access tokens and webhook secrets remain server-side."
  },
  {
    id: "android_sms", name: "Android SMS gateway", category: "Communications",
    required: false, link: null,
    description: "Optional customer-owned Android handset/SIM sending job reminders.",
    mode: "device-pairing", status: "Gateway app, device pairing and messaging controls required",
    secret: "Pairing tokens never appear in downloadable setup files."
  }
]);

export const requiredProviderIds = providers.filter((p) => p.required).map((p) => p.id);
export function getProvider(id) {
  return providers.find((p) => p.id === id) ?? null;
}
export function sanitiseSetup(input) {
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 160) : "";
  const hostname = typeof input.domain === "string" ? input.domain.trim().toLowerCase().slice(0, 253) : "";
  const color = typeof input.primaryColor === "string" && /^#[0-9a-f]{6}$/i.test(input.primaryColor)
    ? input.primaryColor : "#059669";
  const logo = typeof input.logoUrl === "string" ? input.logoUrl.trim().slice(0, 500) : "";
  return {
    schemaVersion: 1,
    company: { name, domain: hostname, logoUrl: /^https:\/\//i.test(logo) ? logo : "", primaryColor: color },
    desiredProviders: [...new Set((Array.isArray(input.desiredProviders) ? input.desiredProviders : [])
      .filter((id) => !!getProvider(id)))],
    generatedAt: new Date().toISOString()
  };
}
