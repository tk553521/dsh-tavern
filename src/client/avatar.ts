/** Resolve a stored avatar value to an `<img src>` URL. */
export function avatarSrc(avatar: string | undefined): string | undefined {
  if (avatar === undefined || avatar === '') return undefined
  if (/^(?:data:|blob:|https?:)/i.test(avatar) || avatar.startsWith('/')) return avatar
  const file = avatar.replace(/\\/g, '/').split('/').pop()
  return file === undefined || file === '' ? avatar : `/tavern/avatars/${encodeURIComponent(file)}`
}
