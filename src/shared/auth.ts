export interface AuthUser {
  username: string;
  mustChangePassword: boolean;
}
export const passwordRules =
  'Use 10 to 200 characters, different from the username and from "admin".';
export function passwordProblem(
  password: string,
  username: string,
): string | undefined {
  if (password.length < 10 || password.length > 200) return passwordRules;
  const lower = password.toLowerCase();
  if (lower === username.toLowerCase() || lower === 'admin')
    return passwordRules;
  return undefined;
}
