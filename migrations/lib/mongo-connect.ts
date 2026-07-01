/**
 * Atlas-friendly Mongo connect for one-off migrations/scripts on Windows.
 *
 * - Loads backend/.env
 * - Optional public DNS for SRV lookup (Windows AV / broken resolver)
 * - Forces IPv4 (family: 4) — many AV tools break IPv6 to Atlas
 * - Longer timeouts than the default driver settings
 *
 * For TLS inspection (corporate AV), set NODE_EXTRA_CA_CERTS in .env and run via:
 *   powershell -File ./scripts/run-moment-migrations.ps1
 * so Node picks up NODE_EXTRA_CA_CERTS before startup.
 */
import dns from 'dns';
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

const backendRoot = path.resolve(__dirname, '../..');
dotenv.config({ path: path.join(backendRoot, '.env') });

function applyDnsOverride(): void {
  const fromEnv = process.env.LOAD_TEST_DNS_SERVERS?.trim();
  if (fromEnv) {
    const servers = fromEnv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (servers.length > 0) {
      dns.setServers(servers);
      console.log('DNS override (LOAD_TEST_DNS_SERVERS):', servers.join(', '));
      return;
    }
  }

  const migrationDns = process.env.MIGRATION_DNS_SERVERS?.trim();
  if (migrationDns) {
    const servers = migrationDns
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (servers.length > 0) {
      dns.setServers(servers);
      console.log('DNS override (MIGRATION_DNS_SERVERS):', servers.join(', '));
      return;
    }
  }

  // Default on Windows: use public resolvers for mongodb+srv lookup (AV often breaks system DNS).
  if (process.platform === 'win32' && process.env.MIGRATION_SKIP_PUBLIC_DNS !== 'true') {
    dns.setServers(['8.8.8.8', '1.1.1.1']);
    console.log('DNS override (Windows default): 8.8.8.8, 1.1.1.1');
  }
}

export function getMongoUri(): string {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    throw new Error(
      'MONGO_URI / MONGODB_URI missing — set it in backend/.env or run via scripts/run-moment-migrations.ps1',
    );
  }
  return uri;
}

export async function connectMongoForMigration(): Promise<typeof mongoose> {
  applyDnsOverride();

  const uri = getMongoUri();
  console.log(
    'Mongo URI source:',
    process.env.MONGODB_URI ? 'MONGODB_URI' : 'MONGO_URI',
  );
  if (process.env.NODE_EXTRA_CA_CERTS) {
    console.log('NODE_EXTRA_CA_CERTS is set');
  }

  const options: mongoose.ConnectOptions = {
    serverSelectionTimeoutMS: 30_000,
    connectTimeoutMS: 30_000,
    socketTimeoutMS: 45_000,
    retryWrites: true,
    retryReads: true,
    family: 4,
  };

  try {
    await mongoose.connect(uri, options);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('\nMongoDB connection failed.\n');
    if (/whitelist|ServerSelection|ReplicaSetNoPrimary/i.test(msg)) {
      console.error('If Atlas Network Access is open (0.0.0.0/0), this is often local AV/firewall/DNS/TLS:');
      console.error('  1. Add to backend/.env:  MIGRATION_DNS_SERVERS=8.8.8.8,1.1.1.1');
      console.error('  2. Or:               LOAD_TEST_DNS_SERVERS=8.8.8.8,1.1.1.1');
      console.error('  3. If AV inspects HTTPS/TLS, set NODE_EXTRA_CA_CERTS to your AV root CA bundle');
      console.error('  4. Run via:  powershell -File ./scripts/run-moment-migrations.ps1');
      console.error('  5. Temporarily allow Node/npx outbound on ports 27017 in AV/firewall\n');
    }
    throw err;
  }

  const db = mongoose.connection.db;
  if (!db) throw new Error('No database handle after connect');
  console.log('Connected to database:', db.databaseName);
  return mongoose;
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}
