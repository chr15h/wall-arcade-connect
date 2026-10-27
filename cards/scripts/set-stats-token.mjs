// Run by John, once: a CLI token limited to "apps" (what /stats needs to read the credit group's usage report), set as
// RARE_PROFILE_TOKEN on the wall-arcade-cards Netlify site (production, functions), then the site redeployed so the
// functions see it. The token is never printed nor written to a file.   node scripts/set-stats-token.mjs
import { createProfileClient } from '@rareprotocol/rare-profile';
import { execFileSync } from 'node:child_process';

const client = createProfileClient({ baseUrl: 'https://studio.superrare.com' });
const flow = await client.auth.startDeviceFlow({ label: 'wall-arcade-cards /stats (usage report)', scopes: ['apps'] });
console.log(`\nOpen this link and press Approve (code ${flow.userCode}):\n${flow.verificationUriComplete}\n`);
const token = await flow.poll();
const usage = await createProfileClient({ baseUrl: 'https://studio.superrare.com', token })
  .creditGroups.usage({ groupId: '60faaf46-ba4b-460c-a82a-adb852371a94', from: '2026-10-27T14:00:00Z', to: new Date().toISOString() });
console.log(`Token OK (${usage.totals.capturedPlays} plays started since the launch). Saving it on Netlify…`);
execFileSync('npx', ['-y', 'netlify-cli@27.9.0', 'env:set', 'RARE_PROFILE_TOKEN', token, '--context', 'production', '--scope', 'functions', '--force'], { stdio: 'ignore' });
const keys = Object.keys(JSON.parse(execFileSync('npx', ['-y', 'netlify-cli@27.9.0', 'env:list', '--json', '--context', 'production', '--scope', 'functions']).toString()));
if (!keys.includes('RARE_PROFILE_TOKEN')) throw new Error('Netlify did not keep RARE_PROFILE_TOKEN');
console.log('RARE_PROFILE_TOKEN is on Netlify. Redeploying…');
execFileSync('npm', ['run', 'deploy'], { stdio: ['ignore', 'ignore', 'inherit'] });
console.log('Done: https://wall-arcade-cards.netlify.app/stats?refresh=1');
