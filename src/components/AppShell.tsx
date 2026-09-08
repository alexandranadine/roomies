import { Outlet } from 'react-router-dom'

export function AppShell() {
  return (
    <div className="min-h-[100dvh] bg-[#ebe4da]">
      <div className="mx-auto min-h-[100dvh] w-full max-w-[430px] overflow-hidden bg-[var(--color-cream)] shadow-[0_0_0_1px_rgb(44_36_27_/_0.06),0_18px_50px_rgb(44_36_27_/_0.08)]">
        <Outlet />
      </div>
    </div>
  )
}
