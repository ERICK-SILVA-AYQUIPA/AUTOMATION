export type Role = 'PLATFORM_ADMIN' | 'TENANT_ADMIN' | 'SUPERVISOR' | 'SELLER';

export type AccessState = 'TRIAL' | 'ACTIVE' | 'GRACE' | 'EXPIRED' | 'CANCELED';
/** Estado de acceso calculado por la API (apps/api/src/plans/subscription-access.ts) */
export interface SubscriptionAccess { state: AccessState; readOnly: boolean; endsAt: string; graceEndsAt: string | null; daysLeft: number }

export interface Me {
  id: string;
  email: string;
  name: string;
  role: Role;
  tenantId: string | null;
  permissions: string[];
  tenant: { id: string; name: string; slug: string; status: 'ACTIVE' | 'SUSPENDED' | 'ONBOARDING'; currency: string; timezone: string; enabledModules: string[]; settings: TenantSettings; logoUrl: string | null; brandColor: string | null; deploymentMode: 'SAAS' | 'DEDICATED' | 'CUSTOM'; subscription: { status: string; trialEndsAt: string | null; currentPeriodEnd: string; plan: { code: string; name: string }; access: SubscriptionAccess } | null } | null;
  /** Instrucciones de pago configuradas por la plataforma (BILLING_CONTACT) */
  billingContact: string;
}

export type WeeklyHours = Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', { open: string; close: string }[]>;
/** Reglas de operación de la empresa (apps/api/src/tenants/tenant-settings.ts) */
export interface TenantSettings {
  catalog: { label: string; trackStockDefault: boolean; volumePricing: boolean; durations: boolean };
  orders: { minAmount: number | null };
  customers: { businessFields: boolean };
  reservations: {
    kind: 'TABLE' | 'APPOINTMENT'; slotMinutes: number; durationMinutes: number; capacity: number | null; maxPartySize: number;
    minNoticeMinutes: number; maxDaysAhead: number; hours: WeeklyHours | null; requireConfirmation: boolean;
  };
}

export interface PriceTier { minQty: number; unitPrice: string }

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
  salePrice: string | null; costPrice: string | null; priceTiers: PriceTier[]; isDefault: boolean; isActive: boolean; effectivePrice: string; stock: number;
  stockLevels: { branchId: string; quantity: number }[];
}

export interface Product {
  id: string; sku: string; barcode: string | null; name: string; description: string | null; categoryId: string | null;
  category: { id: string; name: string } | null; salePrice: string; costPrice: string | null; minStock: number; trackStock: boolean; durationMinutes: number | null;
  status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED'; createdAt: string; updatedAt: string;
  variants: Variant[]; images: { id: string; url: string; alt: string | null }[]; stock: number; lowStock: boolean;
}

/** Con el identificador de usuario de WhatsApp (BSUID) el teléfono puede no llegar */
export interface CustomerRef { id: string; name: string | null; phone: string | null; waProfileName?: string | null }

export interface Customer {
  id: string; name: string | null; phone: string | null; waProfileName: string | null; email: string | null; documentId: string | null; address: string | null;
  customerType: 'PERSON' | 'BUSINESS'; businessName: string | null;
  notes: string | null; tags: string[]; source: string; lastContactAt: string | null; createdAt: string; _count?: { orders: number };
}

export interface OrderItem { id: string; variantId: string; productName: string; variantName: string; sku: string; quantity: number; unitPrice: string; total: string }

export interface Order {
  id: string; number: number; status: string; channel: 'WHATSAPP' | 'MANUAL'; currency: string; subtotal: string; discount: string; total: string;
  notes: string | null; deliveryAddress: string | null; createdAt: string; confirmedAt: string | null;
  customer: CustomerRef; items?: OrderItem[]; _count?: { items: number };
  statusHistory?: { id: string; fromStatus: string | null; toStatus: string; note: string | null; createdAt: string }[];
}

export interface Branch { id: string; name: string; address: string | null; isDefault: boolean; isActive: boolean }

export type ReservationStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW';
export interface Reservation {
  id: string; number: number; startsAt: string; endsAt: string; partySize: number; status: ReservationStatus; channel: 'MANUAL' | 'WHATSAPP';
  productId: string | null; serviceName: string | null; notes: string | null; conversationId: string | null; createdAt: string;
  customer: { id: string; name: string | null; phone: string | null; waProfileName: string | null };
}
export interface Availability {
  date: string; kind: 'TABLE' | 'APPOINTMENT'; durationMinutes?: number; reason: string | null;
  slots: { time: string; startsAt: string; remaining: number }[];
}
