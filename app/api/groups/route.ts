import { GroupAdmissionError, handleGroupAdmission } from "@/lib/group-admission-server"
import type { RequestProof } from "@/lib/protocol"
const json = (value: unknown,status=200) => Response.json(value,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})
export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin")
    if (origin !== new URL(request.url).origin || !/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw new GroupAdmissionError("Open Serotine directly to manage group invitations.",403)
    const reader=request.body?.getReader(); if (!reader) throw new GroupAdmissionError("Invalid group request.")
    let text="", bytes=0;const decoder=new TextDecoder("utf-8",{fatal:true})
    const timer=setTimeout(()=>void reader.cancel(),10_000)
    try { while(true) { const {value,done}=await reader.read(); if(done)break;bytes+=value.byteLength;if(bytes>20000){void reader.cancel();throw new GroupAdmissionError("Group request is too large.",413)}text+=decoder.decode(value,{stream:true}) }text+=decoder.decode() } finally {clearTimeout(timer);reader.releaseLock()}
    const value=JSON.parse(text) as {version:number;action:string;data:unknown;proof:RequestProof}
    if (!value || value.version!==1 || Object.keys(value).length!==4)throw new GroupAdmissionError("Invalid group request.")
    return json({success:true,state:await handleGroupAdmission(value.action,value.data,value.proof)})
  } catch(error) { return json({success:false,error:error instanceof GroupAdmissionError?error.message:"Group membership is temporarily unavailable. Please retry."},error instanceof GroupAdmissionError?error.status:503) }
}
