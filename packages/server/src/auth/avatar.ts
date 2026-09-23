/**
 * Sole source of avatar URLs: the provider hands them to relay via `AuthProvider.avatarUrlFor`,
 * which ships them in `user:info.avatar`; if the frontend doesn't get one it draws an initial block (Avatar.tsx).
 *
 * Built-in providers ship no avatar source of their own; default is ''. Self-hosted avatars need an
 * AUTH_AVATAR_URL template (**must contain a {userId} placeholder**, or startup fails — configuring
 * one URL for everyone is a trap):
 *
 *     AUTH_AVATAR_URL=https://cdn.example.com/avatars/{userId}.png
 *
 * The placeholder is filled URL-encoded: `/`, `?`, `#` in userId must not rewrite URL structure.
 */
export type AvatarUrlFor = (userId: string) => string;

export const NO_AVATAR: AvatarUrlFor = () => '';

export function avatarUrlResolver(template: string | undefined): AvatarUrlFor {
  const tpl = (template ?? '').trim();
  if (!tpl)
    return NO_AVATAR;
  if (!tpl.includes('{userId}')) {
    throw new Error('AUTH_AVATAR_URL must contain the {userId} placeholder');
  }
  return (userId: string): string => {
    const name = (userId ?? '').trim();
    if (!name)
      return '';
    return tpl.split('{userId}').join(encodeURIComponent(name));
  };
}
