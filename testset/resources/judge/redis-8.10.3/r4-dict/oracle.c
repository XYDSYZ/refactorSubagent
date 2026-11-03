#include "dict.h"
#include "monotonic.h"
#include "check.h"
static unsigned keys_freed,values_freed;
static uint64_t hash(const void *key) { (void)key; return 3; }
static int equal(dictCmpCache *cache,const void *a,const void *b) { (void)cache; return !strcmp(a,b); }
static void *dupkey(dict *d,const void *p) { (void)d; return strdup(p); }
static void freekey(dict *d,void *p) { (void)d; keys_freed++; free(p); }
static void freevalue(dict *d,void *p) { (void)d; values_freed++; free(p); }
static dictType type={.hashFunction=hash,.keyDup=dupkey,.keyCompare=equal,.keyDestructor=freekey,.valDestructor=freevalue};
static unsigned seen[64];
static void scan(void *data,const dictEntry *entry,dictEntry **link) {
    (void)data;(void)link; int id=-1;
    if(sscanf(dictGetKey(entry),"k%d",&id)==1 && id>=0 && id<64) seen[id]++;
}
int main(void) {
    monotonicInit(); dict *d=dictCreate(&type); dictExpand(d,64);
    for(int i=0;i<24;i++){char key[16];snprintf(key,sizeof key,"k%d",i);int *v=malloc(sizeof *v);*v=i;dictAdd(d,key,v);}
    CHECK("before-migration",dictSize(d)==24 && dictFind(d,"k7")!=NULL);
    dictExpand(d,256); dictPauseRehashing(d);
    CHECK("migration-active",dictIsRehashing(d));
    dictEntry *existing=NULL; dictEntry *attempt=dictAddRaw(d,"k7",&existing);
    if(attempt){int *v=malloc(sizeof *v);*v=7;dictSetVal(d,attempt,v);}
    CHECK("duplicate-in-old-table",attempt==NULL && existing!=NULL && *(int*)dictGetVal(existing)==7);
    int *value=malloc(sizeof *value);*value=30;
    CHECK("insert-in-new-table",dictAdd(d,"k30",value)==DICT_OK);
    existing=NULL;attempt=dictAddRaw(d,"k30",&existing);
    if(attempt){int *v=malloc(sizeof *v);*v=30;dictSetVal(d,attempt,v);}
    CHECK("duplicate-in-new-table",attempt==NULL && existing!=NULL);
    CHECK("collision-delete",dictDelete(d,"k12")==DICT_OK && !dictFind(d,"k12") && dictFind(d,"k11") && dictFind(d,"k13"));
    unsigned long cursor=0;unsigned steps=0;
    do {cursor=dictScan(d,cursor,scan,NULL);steps++;}while(cursor && steps<10000);
    int complete=!cursor;
    for(int i=0;i<24;i++)if(i!=12 && !seen[i])complete=0;
    CHECK("scan-stable-keys",complete && seen[30]>0);
    dictResumeRehashing(d);while(dictIsRehashing(d))dictRehash(d,1);
    CHECK("migration-complete",dictSize(d)==24 && dictFind(d,"k7") && dictFind(d,"k30"));
    dictRelease(d);CHECK("ownership-release",keys_freed==25 && values_freed==25);
    completed();return 0;
}
