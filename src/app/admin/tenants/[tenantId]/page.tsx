import TenantDetail from "@/components/admin/tenant-detail";
export default async function TenantPage({ params }: { params: Promise<{ tenantId: string }> }) {
  return <TenantDetail tenantId={(await params).tenantId}/>;
}
