/**
 * Purge historical customer imagery from the GCS bucket.
 *
 * Why: our published Privacy Policy makes a "Zero-Retention Biometric Data
 * Guarantee". New try-ons are already ephemeral (returned to the browser as a
 * data: URI, never uploaded) and the reports endpoint is disabled, but objects
 * uploaded before that change are still sitting in the bucket -- public, with
 * a one-year cache header. Until they are deleted the guarantee is not true
 * for past users. The matching DB columns are already cleared by migration
 * 20260916000000_purge_customer_tryon_imagery.sql.
 *
 * What it deletes:
 *   tryons/**   - generated try-on renders (show the customer's body)
 *   reports/**  - customer input body photos and report screenshots
 *
 * What it keeps:
 *   garments/**, products/**  - merchant-owned catalog assets
 *   topups/**                 - payment screenshots (financial records)
 *
 * Usage:
 *   # dry run (default) -- lists what would be deleted, deletes nothing
 *   node scripts/purge-customer-images.mjs
 *
 *   # actually delete
 *   node scripts/purge-customer-images.mjs --confirm
 *
 * Requires the same credentials the app uses: GOOGLE_CLOUD_KEY_JSON,
 * GOOGLE_CLOUD_PROJECT_ID, GOOGLE_CLOUD_BUCKET_NAME.
 */

import { Storage } from '@google-cloud/storage';

const PURGE_PREFIXES = ['tryons/', 'reports/'];

const KEEP_PREFIXES = ['garments/', 'products/', 'topups/'];

function getStorage() {
  const keyJson = process.env.GOOGLE_CLOUD_KEY_JSON;
  if (!keyJson) throw new Error('GOOGLE_CLOUD_KEY_JSON is required');

  let credentials;
  try {
    credentials = JSON.parse(keyJson);
  } catch {
    throw new Error('GOOGLE_CLOUD_KEY_JSON must be valid JSON');
  }

  return new Storage({
    projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
    credentials,
  });
}

async function main() {
  const confirmed = process.argv.includes('--confirm');

  const bucketName = process.env.GOOGLE_CLOUD_BUCKET_NAME;
  if (!bucketName) throw new Error('GOOGLE_CLOUD_BUCKET_NAME is required');

  const bucket = getStorage().bucket(bucketName);

  console.log(`Bucket: ${bucketName}`);
  console.log(`Mode:   ${confirmed ? 'DELETE' : 'DRY RUN (pass --confirm to delete)'}`);
  console.log('');

  let totalFiles = 0;
  let totalBytes = 0;
  let deleted = 0;
  let failed = 0;

  for (const prefix of PURGE_PREFIXES) {
    const [files] = await bucket.getFiles({ prefix });
    console.log(`${prefix}  ->  ${files.length} object(s)`);

    for (const file of files) {
      // Defensive: never touch anything under a keep-prefix, even if a
      // getFiles call were ever widened by mistake.
      if (KEEP_PREFIXES.some((keep) => file.name.startsWith(keep))) {
        console.warn(`  SKIP (protected prefix): ${file.name}`);
        continue;
      }

      totalFiles += 1;
      totalBytes += Number(file.metadata?.size ?? 0);

      if (!confirmed) continue;

      try {
        await file.delete();
        deleted += 1;
        if (deleted % 25 === 0) console.log(`  deleted ${deleted}...`);
      } catch (err) {
        failed += 1;
        console.error(`  FAILED: ${file.name} -- ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const mb = (totalBytes / 1024 / 1024).toFixed(1);
  console.log('');
  console.log(`Matched: ${totalFiles} object(s), ~${mb} MB`);

  if (confirmed) {
    console.log(`Deleted: ${deleted}`);
    if (failed) console.log(`Failed:  ${failed}`);
    console.log('');

    if (failed && deleted === 0) {
      console.log('NOTHING WAS DELETED. The customer images are still in the');
      console.log('bucket and still publicly reachable.');
      console.log('');
      console.log('If the failures above say "storage.objects.delete denied",');
      console.log('the service account can upload but not delete. Grant it the');
      console.log('Storage Object Admin role on this bucket (or run the purge');
      console.log('as an account that already has it), then re-run.');
      process.exitCode = 1;
      return;
    }

    if (failed) {
      console.log(`WARNING: ${failed} object(s) could not be deleted and remain`);
      console.log('in the bucket. Re-run after resolving the errors above.');
      process.exitCode = 1;
    }

    if (deleted) {
      console.log('Note: objects were served with a 1-year cache header, so any');
      console.log('already-cached copies at a CDN/browser edge may persist until');
      console.log('they expire. The origin objects that were deleted are gone.');
    }
  } else {
    console.log('Nothing deleted. Re-run with --confirm to delete.');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
