import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { AuthStore, defaultAdmin } from './auth-store.js';
import { passwordProblem } from '../shared/auth.js';

async function readPassword(): Promise<string> {
  const argument = process.argv[2];
  if (argument) return argument;
  if (!process.stdin.isTTY)
    throw new Error('Pass the new password as an argument.');
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await prompt.question(`New password for ${defaultAdmin.username}: `);
  } finally {
    prompt.close();
  }
}
const password = await readPassword();
const problem = passwordProblem(password, defaultAdmin.username);
if (problem) {
  console.error(problem);
  process.exit(1);
}
const database = process.env.DATABASE_PATH ?? 'data/opendots.sqlite';
// Opening a missing path would create a fresh database and reset its admin,
// leaving the real one untouched.
if (!existsSync(database)) {
  console.error(
    `No database at ${database}. Run this from the OpenDots directory or set DATABASE_PATH.`,
  );
  process.exit(1);
}
const store = new AuthStore(database);
store.resetPassword(defaultAdmin.username, password);
store.close();
console.log(
  `Password reset for ${defaultAdmin.username}; all sessions were signed out. You will be asked to choose a new password after signing in.`,
);
