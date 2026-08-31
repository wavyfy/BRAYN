import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <main style={{ display: 'flex', justifyContent: 'center', paddingTop: '4rem' }}>
      <SignIn />
    </main>
  );
}
