import { Suspense } from 'react';
import { SetPasswordForm } from '@/components/set-password-form';

export default function Page() {
  return (
    <Suspense>
      <SetPasswordForm mode="reset" />
    </Suspense>
  );
}
