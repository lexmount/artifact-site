import CollectionPage from "@/components/sharing/collection-page";
export const metadata = { robots: { index: false, follow: false } };
export default async function Page({params}:{params:Promise<{token:string}>}) { return <CollectionPage token={(await params).token}/>; }
