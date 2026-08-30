import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { SESSION_COOKIE } from '@/server/modules/auth/service';

export default async function Home() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  redirect(token ? '/home' : '/login');
}
