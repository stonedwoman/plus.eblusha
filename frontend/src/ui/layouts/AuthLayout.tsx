import { Outlet, NavLink } from 'react-router-dom'

export default function AuthLayout() {
  return (
    <div className="auth-layout">
      <aside className="auth-brand">
        <div className="logo">
          <span>Е</span>
          <span className="b">Б</span>
          <span>луша</span>
        </div>
        <div className="subtitle">На каждый хуй с винтом есть жопа с лабиринтом</div>
      </aside>
      <section className="auth-content">
        <div className="auth-mobile-logo">
          <div className="logo" style={{ fontSize: '28pt' }}>
            <span>Е</span>
            <span className="b">Б</span>
            <span>луша</span>
          </div>
        </div>
        <div className="auth-nav">
          <NavLink to="/auth" end>
            Войти
          </NavLink>
          <NavLink to="/auth/register">Регистрация</NavLink>
        </div>
        <Outlet />
      </section>
    </div>
  )
}
