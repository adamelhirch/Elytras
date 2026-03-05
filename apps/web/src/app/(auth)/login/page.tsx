import { SignInForm } from "@/components/auth/sign-in-form";

export default function LoginPage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-[#0f1117]">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white tracking-tight">Elytras</h1>
          <p className="text-gray-400 mt-2 text-sm">Connectez-vous à votre espace</p>
        </div>
        <SignInForm />
      </div>
    </main>
  );
}
