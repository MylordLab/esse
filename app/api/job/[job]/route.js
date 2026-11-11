import resolver from '../../../../redeflix.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(_request, context) {
 const {job}=await context.params;
 if(!/^[a-z0-9]{6,40}$/i.test(job))return Response.json({error:'Job inválido.'},{status:400,headers:{'Cache-Control':'no-store'}});
 const out=resolver.getJob(job);
 if(!out)return Response.json({status:'error',error:'Job não encontrado ou expirado. Faça a busca novamente.'},{status:404,headers:{'Cache-Control':'no-store'}});
 if(out.status==='ready')return Response.json({status:'ready',...out.data},{headers:{'Cache-Control':'no-store'}});
 if(out.status==='error')return Response.json({status:'error',error:out.error},{headers:{'Cache-Control':'no-store'}});
 return Response.json({status:'pending'},{headers:{'Cache-Control':'no-store'}});
}
