'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard, MessagesSquare, Bot, Package, Tags, Boxes, ShoppingCart, Users, Workflow, Plug, BarChart3, UserCog, Settings,
  Menu, X, Search, Sun, Moon, Monitor, LogOut, MessageSquareText, Building2, Bell,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';
import { api } from '@/lib/api';
import { cn, Spinner } from '@/components/ui';
import { SubscriptionBanner } from '@/components/subscription-banner';
import { ROLE_LABEL, customerLabel, money, phoneLabel } from '@/lib/format';
import type { Customer, Order, Paged, Product } from '@/lib/types';

interface NavItem { href: string; label: string; icon: typeof LayoutDashboard; permission?: string; soon?: string }

/** Módulos con "soon" aún no están construidos: se muestran deshabilitados, nunca como enlaces rotos. */
const NAV: NavItem[] = [
  { href: '/inicio', label: 'Inicio', icon: LayoutDashboard, permission: 'tenant:read' },
  { href: '/conversaciones', label: 'Conversaciones', icon: MessagesSquare, permission: 'conversations:read' },
  { href: '/asistente', label: 'Asistente IA', icon: Bot, permission: 'ai:configure' },
  { href: '/productos', label: 'Productos', icon: Package, permission: 'products:read' },
  { href: '/categorias', label: 'Categorías', icon: Tags, permission: 'products:read' },
  { href: '/inventario', label: 'Inventario', icon: Boxes, permission: 'inventory:read' },
  { href: '/pedidos', label: 'Pedidos', icon: ShoppingCart, permission: 'orders:read' },
  { href: '/clientes', label: 'Clientes', icon: Users, permission: 'customers:read' },
  { href: '/automatizaciones', label: 'Automatizaciones', icon: Workflow, permission: 'automations:manage', soon: 'Fase 7' },
  { href: '/integraciones', label: 'Integraciones', icon: Plug, permission: 'integrations:manage' },
  { href: '/reportes', label: 'Reportes', icon: BarChart3, permission: 'reports:read' },
  { href: '/usuarios', label: 'Usuarios', icon: UserCog, permission: 'users:read' },
  { href: '/configuracion', label: 'Configuración', icon: Settings, permission: 'tenant:read' },
];

const PLATFORM_NAV: NavItem[] = [{ href: '/plataforma', label: 'Empresas', icon: Building2, permission: 'platform:manage' }];

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { me, can } = useAuth();
  const path = usePathname();
  const items = (me?.role === 'PLATFORM_ADMIN' ? PLATFORM_NAV : NAV).filter((i) => !i.permission || can(i.permission));
  return (
    <nav className="flex h-full flex-col gap-1 p-3" aria-label="Menú principal">
      <div className="mb-4 flex items-center gap-2 px-2 pt-1">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-fg">
          <MessageSquareText className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{me?.tenant?.name ?? 'AI Sales Assistant'}</p>
          <p className="truncate text-xs text-muted">{me?.tenant?.subscription?.plan.name ? `Plan ${me.tenant.subscription.plan.name}` : 'Plataforma'}</p>
        </div>
      </div>
      {items.map((i) => {
        const active = path === i.href || path.startsWith(`${i.href}/`);
        const Icon = i.icon;
        if (i.soon)
          return (
            <span key={i.href} className="flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted/70" title={`Disponible en la ${i.soon}`} aria-disabled="true">
              <Icon className="size-4" />
              <span className="flex-1">{i.label}</span>
              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">Pronto</span>
            </span>
          );
        return (
          <Link
            key={i.href}
            href={i.href}
            onClick={onNavigate}
            className={cn('flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition', active ? 'bg-surface-2 font-medium text-text' : 'text-muted hover:bg-surface-2 hover:text-text')}
            aria-current={active ? 'page' : undefined}
          >
            <Icon className="size-4" />
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { can } = useAuth();
  const box = useRef<HTMLDivElement>(null);
  const term = q.trim();
  const { data, isFetching } = useQuery({
    queryKey: ['global-search', term],
    enabled: term.length >= 2,
    queryFn: async () => {
      const [products, customers, orders] = await Promise.all([
        can('products:read') ? api<Paged<Product>>('/products', { query: { q: term, pageSize: 5 } }) : null,
        can('customers:read') ? api<Paged<Customer>>('/customers', { query: { q: term, pageSize: 5 } }) : null,
        can('orders:read') ? api<Paged<Order>>('/orders', { query: { q: term, pageSize: 5 } }) : null,
      ]);
      return { products: products?.items ?? [], customers: customers?.items ?? [], orders: orders?.items ?? [] };
    },
  });
  useEffect(() => {
    const h = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        box.current?.querySelector('input')?.focus();
      }
    };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', k);
    };
  }, []);
  const go = (href: string) => {
    setOpen(false);
    setQ('');
    router.push(href);
  };
  const empty = data && !data.products.length && !data.customers.length && !data.orders.length;
  return (
    <div ref={box} className="relative w-full max-w-md">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false);
            e.currentTarget.blur();
          }
        }}
        placeholder="Buscar productos, clientes, pedidos…"
        className="h-9 w-full rounded-lg border border-border bg-surface pl-9 pr-14 text-sm outline-none focus:border-primary"
        aria-label="Búsqueda global"
      />
      <kbd className="absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-border px-1.5 text-[10px] text-muted sm:block">Ctrl K</kbd>
      {open && term.length >= 2 && (
        <div className="absolute left-0 right-0 top-11 z-40 max-h-96 overflow-y-auto rounded-xl border border-border bg-surface p-2 shadow-xl">
          {isFetching && !data && <div className="flex justify-center p-4"><Spinner /></div>}
          {empty && <p className="p-3 text-sm text-muted">Sin resultados para “{term}”.</p>}
          {!!data?.products.length && <p className="px-2 pb-1 pt-2 text-xs font-medium uppercase text-muted">Productos</p>}
          {data?.products.map((p) => (
            <button key={p.id} onClick={() => go(`/productos/${p.id}`)} className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-sm hover:bg-surface-2">
              <span>{p.name} <span className="text-muted">· {p.sku}</span></span>
              <span className="text-muted">{p.stock} u.</span>
            </button>
          ))}
          {!!data?.customers.length && <p className="px-2 pb-1 pt-2 text-xs font-medium uppercase text-muted">Clientes</p>}
          {data?.customers.map((c) => (
            <button key={c.id} onClick={() => go(`/clientes/${c.id}`)} className="flex w-full rounded-lg px-2 py-2 text-left text-sm hover:bg-surface-2">
              {c.name ?? c.waProfileName ?? 'Sin nombre'} <span className="ml-2 text-muted">{phoneLabel(c.phone)}</span>
            </button>
          ))}
          {!!data?.orders.length && <p className="px-2 pb-1 pt-2 text-xs font-medium uppercase text-muted">Pedidos</p>}
          {data?.orders.map((o) => (
            <button key={o.id} onClick={() => go(`/pedidos/${o.id}`)} className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-sm hover:bg-surface-2">
              <span>#{o.number} · {customerLabel(o.customer)}</span>
              <span className="text-muted">{money(o.total, o.currency)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  const next = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  const label = { light: 'Tema claro', dark: 'Tema oscuro', system: 'Tema del sistema' }[theme];
  return (
    <button onClick={() => setTheme(next)} className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-text" title={label} aria-label={`${label}. Cambiar tema`}>
      <Icon className="size-4" />
    </button>
  );
}

function Notifications() {
  const { can } = useAuth();
  const { data } = useQuery({
    queryKey: ['stock-alerts'],
    enabled: can('inventory:read'),
    queryFn: () => api<{ id: string }[]>('/inventory/alerts'),
    refetchInterval: 60_000,
  });
  if (!can('inventory:read')) return null;
  return (
    <Link href="/inventario?tab=alertas" className="relative rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-text" aria-label={`Alertas de stock: ${data?.length ?? 0}`}>
      <Bell className="size-4" />
      {!!data?.length && <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-danger text-[10px] font-semibold text-white">{data.length > 9 ? '9+' : data.length}</span>}
    </Link>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { me, logout } = useAuth();
  const [mobile, setMobile] = useState(false);
  return (
    <div className="min-h-dvh lg:pl-64">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-border bg-surface lg:block">
        <Sidebar />
      </aside>
      {mobile && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobile(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 border-r border-border bg-surface">
            <button className="absolute right-3 top-3 rounded-md p-1 text-muted" onClick={() => setMobile(false)} aria-label="Cerrar menú">
              <X className="size-5" />
            </button>
            <Sidebar onNavigate={() => setMobile(false)} />
          </aside>
        </div>
      )}
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-bg/80 px-4 backdrop-blur lg:px-8">
        <button className="rounded-lg p-2 text-muted hover:bg-surface-2 lg:hidden" onClick={() => setMobile(true)} aria-label="Abrir menú">
          <Menu className="size-5" />
        </button>
        {me?.role !== 'PLATFORM_ADMIN' ? <GlobalSearch /> : <div className="flex-1" />}
        <div className="ml-auto flex items-center gap-1">
          <Notifications />
          <ThemeSwitch />
          <div className="ml-2 hidden text-right sm:block">
            <p className="text-sm font-medium leading-tight">{me?.name}</p>
            <p className="text-xs text-muted">{me ? ROLE_LABEL[me.role] : ''}</p>
          </div>
          <button onClick={logout} className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-text" title="Cerrar sesión" aria-label="Cerrar sesión">
            <LogOut className="size-4" />
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 lg:px-8 lg:py-8">
        <SubscriptionBanner />
        {children}
      </main>
    </div>
  );
}
