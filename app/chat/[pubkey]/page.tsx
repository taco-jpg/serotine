export const runtime = 'edge';

import ChatClient from './chat-client';

export default function Page({ params }: { params: { pubkey: string } }) {
  return <ChatClient params={params} />;
}
