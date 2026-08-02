import { useLocation, useNavigate } from 'react-router-dom'
import ProjectBoard from '../components/board/ProjectBoard'
import { useProjects } from '../hooks/useProjects'
import { useEffect } from 'react'

export default function DashboardPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const { projects } = useProjects()

  const slug = location.pathname.split('/dashboard/')[1] || ''
  const project = projects.find(p => p.slug === slug)

  useEffect(() => {
    if (projects.length > 0 && !project) {
      navigate('/home', { replace: true })
    }
  }, [projects, project, navigate])

  if (!project) return null

  return <ProjectBoard project={project} />
}
