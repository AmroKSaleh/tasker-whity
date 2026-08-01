const fs = require('fs');
let content = fs.readFileSync('supabase/functions/mcp/index.ts', 'utf8');

const toolDefsTarget = `      required: ['project_id', 'context'],
    },
  },
  {
    name: 'update_project',`;

const toolDefsReplacement = `      required: ['project_id', 'context'],
    },
  },
  {
    name: 'get_project_delta',
    description: 'Computes what has changed in a project since the last published update (tasks completed, new tasks, blocked items). Call this BEFORE drafting a project update so you have the facts.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix, slug, or UUID' }
      },
      required: ['project_id'],
    }
  },
  {
    name: 'post_project_update',
    description: 'Creates a DRAFT project update with a health status and a rich text body. The server automatically attaches the delta (changes since the last update) to it. After calling this, tell the user to review and publish the draft in the Web UI.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix, slug, or UUID' },
        health: { type: 'string', enum: ['on_track', 'at_risk', 'off_track'] },
        body: { type: 'string', description: 'Rich text narrative of the update' }
      },
      required: ['project_id', 'health', 'body'],
    }
  },
  {
    name: 'update_project',`;

const handlersTarget = `      await sb.from('projects').update({ context: merged }).eq('id', project.id)
      return \`Updated context for "\${project.name}".\`
    }

    case 'update_project': {`;

const handlersReplacement = `      await sb.from('projects').update({ context: merged }).eq('id', project.id)
      return \`Updated context for "\${project.name}".\`
    }

    case 'get_project_delta': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return \`Project "\${args.project_id}" not found.\`

      const { data: lastUpdate } = await sb.from('project_updates')
        .select('created_at')
        .eq('project_id', project.id)
        .eq('status', 'published')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      const since = lastUpdate ? lastUpdate.created_at : project.created_at

      const { data: completed } = await sb.from('tasks').select('short_id, text').eq('project_id', project.id).eq('is_deleted', false).eq('is_completed', true).gte('completed_at', since)
      const { data: added } = await sb.from('tasks').select('short_id, text').eq('project_id', project.id).eq('is_deleted', false).gte('created_at', since)
      const { data: blocked } = await sb.from('tasks').select('short_id, text').eq('project_id', project.id).eq('is_deleted', false).eq('status', 'blocked')

      const delta = {
        since,
        tasks_completed: completed?.length || 0,
        tasks_added: added?.length || 0,
        blocked_items: blocked?.length || 0,
        completed_list: completed?.map(t => \`\${t.short_id}: \${t.text}\`) || [],
        added_list: added?.map(t => \`\${t.short_id}: \${t.text}\`) || [],
        blocked_list: blocked?.map(t => \`\${t.short_id}: \${t.text}\`) || []
      }

      return JSON.stringify(delta, null, 2)
    }

    case 'post_project_update': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return \`Project "\${args.project_id}" not found.\`

      const { data: lastUpdate } = await sb.from('project_updates')
        .select('created_at')
        .eq('project_id', project.id)
        .eq('status', 'published')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      const since = lastUpdate ? lastUpdate.created_at : project.created_at
      const { data: completed } = await sb.from('tasks').select('short_id, text').eq('project_id', project.id).eq('is_deleted', false).eq('is_completed', true).gte('completed_at', since)
      const { data: added } = await sb.from('tasks').select('short_id, text').eq('project_id', project.id).eq('is_deleted', false).gte('created_at', since)
      const { data: blocked } = await sb.from('tasks').select('short_id, text').eq('project_id', project.id).eq('is_deleted', false).eq('status', 'blocked')

      const delta = {
        since,
        tasks_completed: completed?.length || 0,
        tasks_added: added?.length || 0,
        blocked_items: blocked?.length || 0,
        completed_list: completed?.map(t => \`\${t.short_id}: \${t.text}\`) || [],
        added_list: added?.map(t => \`\${t.short_id}: \${t.text}\`) || [],
        blocked_list: blocked?.map(t => \`\${t.short_id}: \${t.text}\`) || []
      }

      const { error } = await sb.from('project_updates').insert({
        project_id: project.id,
        user_id: userId,
        health: args.health,
        body: args.body,
        status: 'draft',
        delta
      })

      if (error) return \`Error creating draft update: \${error.message}\`
      return \`Draft project update created successfully! Please tell the user to review and publish it from the Web UI.\`
    }

    case 'update_project': {`;

content = content.replace(toolDefsTarget, toolDefsReplacement);
content = content.replace(handlersTarget, handlersReplacement);

fs.writeFileSync('supabase/functions/mcp/index.ts', content);
console.log('Injection successful');
