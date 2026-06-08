const role = process.argv[2];
if (!role) {
  console.error('Usage: node scripts/start-with-role.cjs <api-ws|billing-worker|moments-worker|image-worker|monolith>');
  process.exit(1);
}
process.env.ECS_SERVICE_ROLE = role;
require('../dist/server.js');
