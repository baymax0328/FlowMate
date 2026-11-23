-- Recover only provable usage ownership. Ambiguous team-session usage stays unassigned.
UPDATE usage_records SET user_id=COALESCE(
 (SELECT q.creator_id FROM runs r JOIN requests q ON q.id=r.request_id WHERE r.id=usage_records.run_id AND r.organization_id=usage_records.organization_id),
 (SELECT uploader_id FROM discovery_imports i WHERE i.id=usage_records.import_id AND i.organization_id=usage_records.organization_id),
 (SELECT owner_id FROM agent_sessions s WHERE s.id=usage_records.session_id AND s.organization_id=usage_records.organization_id AND s.mode='personal')
) WHERE user_id IS NULL;
