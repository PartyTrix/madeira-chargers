// Cloudflare Worker "charger-timer": starts the charger sites' GitHub workflows
// on time, because GitHub's own schedules run late or not at all.
// Needs one secret, GITHUB_TOKEN: a fine-grained token with
// "Actions: Read and write" on madeira-chargers, chargeportugal and chargefrance.
// Cron triggers: "*/15 * * * *" and "17 4 * * *".

const EVERY_15_MIN = [
  ["madeira-chargers", "status.yml"], // live plug status (Madeira + Portugal)
  ["chargeportugal", "deploy.yml"],   // chargeportugal.com
  ["chargefrance", "deploy.yml"],     // fastchargefrance.com
];
const DAILY = [
  ["madeira-chargers", "site.yml"],   // MOBI.E chargers and prices, madeirachargers.com
];

async function run(env, [repo, workflow]) {
  const res = await fetch(`https://api.github.com/repos/PartyTrix/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "charger-timer",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  const line = `${repo}/${workflow}: ${res.status}`;
  console.log(line);
  return line;
}

async function runAll(env, cron) {
  const list = cron === "17 4 * * *" ? DAILY : EVERY_15_MIN;
  return Promise.all(list.map((w) => run(env, w)));
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAll(env, event.cron));
  },
  // No public URL: nobody else can start the workflows.
  async fetch() { return new Response("Not here.", { status: 404 }); },
};
