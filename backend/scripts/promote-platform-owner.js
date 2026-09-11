require('dotenv').config();
const prisma = require('../src/lib/prisma');

async function main() {
  if (process.env.PLATFORM_OWNER_MIGRATION_ACK !== 'YES') throw new Error('Set PLATFORM_OWNER_MIGRATION_ACK=YES to run this migration');
  const targetEmail=(process.env.PLATFORM_OWNER_EMAIL||'').trim().toLowerCase();
  if(!targetEmail) throw new Error('PLATFORM_OWNER_EMAIL is required');
  const legacyEmail=(process.env.LEGACY_PLATFORM_EMAIL||'platform@ndsairconditioning.com').trim().toLowerCase();
  const target=await prisma.user.findUnique({where:{email:targetEmail},include:{business:true}});
  if(!target) throw new Error(`Owner account not found: ${targetEmail}`);
  if(target.businessId && !target.business?.isDefault) throw new Error('Target account is attached to a non-default tenant; refusing to promote it');
  const result=await prisma.$transaction(async(tx)=>{
    const promoted=await tx.user.update({where:{id:target.id},data:{role:'ADMIN',businessId:null,isActive:true}});
    if(legacyEmail!==targetEmail){
      const legacy=await tx.user.findUnique({where:{email:legacyEmail}});
      if(legacy && legacy.id!==target.id && !legacy.businessId && legacy.role==='ADMIN'){
        await tx.user.update({where:{id:legacy.id},data:{isActive:false}});
      }
    }
    return promoted;
  });
  console.log(`Platform owner ready: ${result.email} (businessId=${result.businessId}, role=${result.role})`);
}
main().catch(err=>{console.error(err.message);process.exitCode=1}).finally(async()=>{await prisma.$disconnect()});
