'use client';

import { Home, Package, Users, FileText, Truck, Boxes, BarChart3 } from 'lucide-react';

const navItems = [
  { name: 'Home', icon: Home, href: '/', active: true },
  { name: 'Products', icon: Package, href: '/products' },
  { name: 'Partners', icon: Users, href: '/partners' },
  { name: 'Operations', icon: FileText, href: '/operations' },
  { name: 'Documents', icon: FileText, href: '/documents' },
  { name: 'Inventory', icon: Boxes, href: '/inventory' },
  { name: 'Shipments', icon: Truck, href: '/shipments' },
  { name: 'Analytics', icon: BarChart3, href: '/analytics' },
];

export default function Sidebar() {
  return (
    <aside className="w-56 bg-card border-r border-border flex flex-col">
      <div className="p-4 border-b border-border">
        <h1 className="text-lg font-semibold">Das Operator</h1>
        <p className="text-xs text-muted-foreground">ERP v0.2</p>
      </div>
      <nav className="flex-1 p-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <a
              key={item.name}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2 rounded text-sm transition ${
                item.active
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <Icon className="h-4 w-4" />
              {item.name}
            </a>
          );
        })}
      </nav>
    </aside>
  );
}
