import resolver from '../../../../redeflix.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(_request, context) {
 const {id}=await context.params;
 if(!/^\d{1,12}$/.test(id))return Response.json({error:'ID TMDB inválido.'},{status:400,headers:{'Cache-Control':'no-store'}});
 try{
  // Cache atingido responde na hora; caso contrário devolve um job para polling.
  const out=resolver.enqueue('filme',id);
  if(out.status==='ready')return Response.json(out.data,{headers:{'Cache-Control':'no-store'}});
  return Response.json({job:out.job,status:'pending'},{status:202,headers:{'Cache-Control':'no-store'}});
 }catch(error){console.error('Falha na resolução do ID:',error.message);return Response.json({error:'Erro ao consultar o provedor.'},{status:500,headers:{'Cache-Control':'no-store'}})}
}
