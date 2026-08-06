'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ComponentType } from 'react'
import { LayoutDashboard, Megaphone, Package, PieChart, Plug, Settings, Wallet, Warehouse } from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'

interface NavItem {
  label: string
  href: string | null
  icon: ComponentType<{ className?: string }>
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Vendas', href: '/', icon: LayoutDashboard },
  { label: 'Produtos', href: null, icon: Package },
  { label: 'Estoque', href: null, icon: Warehouse },
  { label: 'Anúncios', href: null, icon: Megaphone },
  { label: 'Financeiro', href: null, icon: Wallet },
  { label: 'Margem de contribuição', href: '/margem-contribuicao', icon: PieChart },
  { label: 'Integrações', href: null, icon: Plug },
  { label: 'Configurações', href: null, icon: Settings },
]

export function AppSidebar() {
  const pathname = usePathname()
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="px-3 py-2 text-sm font-semibold">
        <span className="group-data-[collapsible=icon]:hidden">Dashboard Marketplaces</span>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => (
                <SidebarMenuItem key={item.label}>
                  {item.href ? (
                    <SidebarMenuButton asChild isActive={pathname === item.href} tooltip={item.label}>
                      <Link href={item.href}>
                        <item.icon className="h-4 w-4" />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  ) : (
                    <SidebarMenuButton
                      aria-disabled="true"
                      onClick={(event) => event.preventDefault()}
                      className="opacity-50"
                      style={{ pointerEvents: 'auto' }}
                      tooltip={`${item.label} (em breve)`}
                    >
                      <item.icon className="h-4 w-4" />
                      <span>{item.label}</span>
                      <span className="ml-auto text-xs text-muted-foreground">em breve</span>
                    </SidebarMenuButton>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}
