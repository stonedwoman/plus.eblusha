import { Outlet, NavLink, useLocation } from 'react-router-dom'

export default function AuthLayout() {
  const location = useLocation()
  const tab = location.pathname.startsWith('/auth/register') ? 'register' : 'login'

  return (
    <div className="auth-layout eb-no-drag">
      <aside className="auth-brand">
        <div className="logo">
          <span>Е</span>
          <span className="b">Б</span>
          <span>луша</span>
        </div>
        <div className="subtitle">На каждый хуй с винтом есть жопа с лабиринтом</div>
      </aside>
      <section className="auth-content eb-no-drag" data-tab={tab}>
        <div className="auth-mobile-logo">
          <div className="logo" style={{ fontSize: '28pt' }}>
            <span>Е</span>
            <span className="b">Б</span>
            <span>луша</span>
          </div>
        </div>
        <nav className="auth-nav">
          <NavLink to="/auth" end>
            Войти
          </NavLink>
          <NavLink to="/auth/register">Регистрация</NavLink>
        </nav>
        <Outlet />
      </section>
    </div>
  )
}
