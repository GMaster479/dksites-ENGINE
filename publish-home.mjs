// publish-home.mjs — put the dksites.com homepage (site/home/) online.
//
//   node publish-home.mjs              upload it to the PREVIEW: https://dksites-home.dksites.com
//   node publish-home.mjs --go-live    upload it AND make dksites.com show it
//   node publish-home.mjs --take-down  dksites.com goes back to "coming soon" (preview stays)
//
// The homepage is a normal R2 site under clients/dksites-home/, the same way customer
// sites are stored. Going live just writes routes/dksites.com.json, which the Worker reads.
// "dksites-home" is a reserved name: no customer preview can ever be given it.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { config } from './src/config.js';
import { deployPreview, mapCustomDomain } from './src/deploy/r2.js';

const SLUG = 'dksites-home';
const HOST = 'dksites.com';
const here = dirname(fileURLToPath(import.meta.url));
const arg = process.argv[2] || '';

if (arg === '--take-down') {
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${config.cfAccountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.r2AccessKeyId, secretAccessKey: config.r2SecretKey },
  });
  await s3.send(new DeleteObjectCommand({ Bucket: config.r2Bucket, Key: `routes/${HOST}.json` }));
  console.log(`✓ ${HOST} is back to "coming soon". The preview is still at https://${SLUG}.${HOST}/`);
  process.exit(0);
}

const r = await deployPreview(join(here, 'site', 'home'), SLUG);
console.log(`✓ Uploaded ${r.uploaded.length} files.`);
console.log(`  Preview: https://${SLUG}.${HOST}/`);

if (arg === '--go-live') {
  await mapCustomDomain(HOST, SLUG);
  console.log(`✓ https://${HOST}/ now shows the homepage (give it a minute; www redirects to it).`);
} else {
  console.log(`  When you like it: node publish-home.mjs --go-live`);
}
