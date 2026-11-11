import resolver from '../../../../../../redeflix.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(_request, context) {
 const {id,season,episode}=await context.params;
 if(!/^\d{1,12}$/.test(id)||!/^\d{1,4}$/.test(season)||!/^\d{1,4}$/.test(episode))return Response.json({error:'Parâmetros inválidos.'},{status:400,headers:{'Cache-Control':'no-store'}});
 try{
  const out=resolver.enqueue('serie',id,season,episode);
  if(out.status==='ready')return Response.json(out.data,{headers:{'Cache-Control':'no-store'}});
  return Response.json({job:out.job,status:'pending'},{status:202,headers:{'Cache-Control':'no-store'}});
 }catch(error){console.error('Falha na resolução da série:',error.message);return Response.json({error:'Erro ao consultar o provedor.'},{status:500,headers:{'Cache-Control':'no-store'}})}
}
