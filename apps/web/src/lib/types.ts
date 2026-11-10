export type Role = 'PLATFORM_ADMIN' | 'TENANT_ADMIN' | 'SUPERVISOR' | 'SELLER';

export interface Me {
  id: string;
  email: string;
  name: string;
  role: Role;
  tenantId: string | null;
  permissions: string[];
  tenant: { id: string; name: string; slug: string; currency: string; timezone: string; subscription: { status: string; trialEndsAt: string | null; plan: { code: string; name: string } } | null } | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

export interface Category { id: string; name: string; slug: string; description: string | null; isActive: boolean; productCount?: number }

export interface Variant {
  id: string; sku: string; barcode: string | null; name: string; attributes: Record<string, string>;
  salePrice: string | null; costPrice: string | null; isDefault: boolean; isActive: boolean; effectivePrice: string; stock: number;
  stockLevels: { branchId: string; quantity: number }[];
}

export interface Product {
  id: string; sku: string; barcode: string | null; name: string; description: string | null; categoryId: string | null;
  category: { id: string; name: string } | null; salePrice: string; costPrice: string | null; minStock: number;
  status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED'; createdAt: string; updatedAt: string;
  variants: Variant[]; images: { id: string; url: string; alt: string | null }[]; stock: number; lowStock: boolean;
}

export interface Customer {
  id: string; name: string | null; phone: string; email: string | null; documentId: string | null; address: string | null;
  notes: string | null; tags: string[]; source: string; lastContactAt: string | null; createdAt: string; _count?: { orders: number };
}

export interface OrderItem { id: string; variantId: string; productName: string; variantName: string; sku: string; quantity: number; unitPrice: string; total: string }

export interface Order {
  id: string; number: number; status: string; channel: 'WHATSAPP' | 'MANUAL'; currency: string; subtotal: string; discount: string; total: string;
  notes: string | null; deliveryAddress: string | null; createdAt: string; confirmedAt: string | null;
  customer: { id: string; name: string | null; phone: string }; items?: OrderItem[]; _count?: { items: number };
  statusHistory?: { id: string; fromStatus: string | null; toStatus: string; note: string | null; createdAt: string }[];
}

export interface Branch { id: string; name: string; address: string | null; isDefault: boolean; isActive: boolean }
